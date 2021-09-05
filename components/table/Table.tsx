import RcTable, { Summary } from '../vc-table';
import { TableProps as RcTableProps, INTERNAL_HOOKS } from '../vc-table/Table';
import Spin, { SpinProps } from '../spin';
import Pagination from '../pagination';
import { TooltipProps } from '../tooltip';
import usePagination, { DEFAULT_PAGE_SIZE, getPaginationParam } from './hooks/usePagination';
import useLazyKVMap from './hooks/useLazyKVMap';
import { Breakpoint } from '../_util/responsiveObserve';
import {
  TableRowSelection,
  GetRowKey,
  ColumnType,
  ColumnsType,
  TableCurrentDataSource,
  SorterResult,
  GetPopupContainer,
  ExpandType,
  TablePaginationConfig,
  SortOrder,
  TableLocale,
  TableAction,
  FilterValue,
} from './interface';
import useSelection, {
  SELECTION_ALL,
  SELECTION_INVERT,
  SELECTION_NONE,
} from './hooks/useSelection';
import useSorter, { getSortData, SortState } from './hooks/useSorter';
import useFilter, { getFilterData, FilterState } from './hooks/useFilter';
import useTitleColumns from './hooks/useTitleColumns';
import renderExpandIcon from './ExpandIcon';
import scrollTo from '../_util/scrollTo';
import defaultLocale from '../locale/en_US';
import Column from './Column';
import ColumnGroup from './ColumnGroup';
import { SizeType } from '../config-provider';
import devWarning from '../vc-util/devWarning';
import { computed, defineComponent, ref, toRef, watchEffect } from 'vue';
import { DefaultRecordType } from '../vc-table/interface';
import useBreakpoint from '../_util/hooks/useBreakpoint';
import { convertChildrenToColumns } from '../vc-table/hooks/useColumns';
import useConfigInject from '../_util/hooks/useConfigInject';
import { useLocaleReceiver } from '../locale-provider/LocaleReceiver';
import classNames from '../_util/classNames';
import omit from '../_util/omit';

export type { ColumnsType, TablePaginationConfig };

const EMPTY_LIST: any[] = [];

interface ChangeEventInfo<RecordType = DefaultRecordType> {
  pagination: {
    current?: number;
    pageSize?: number;
    total?: number;
  };
  filters: Record<string, FilterValue | null>;
  sorter: SorterResult<RecordType> | SorterResult<RecordType>[];

  filterStates: FilterState<RecordType>[];
  sorterStates: SortState<RecordType>[];

  resetPagination: Function;
}

export interface TableProps<RecordType = DefaultRecordType>
  extends Omit<
    RcTableProps<RecordType>,
    | 'transformColumns'
    | 'internalHooks'
    | 'internalRefs'
    | 'data'
    | 'columns'
    | 'scroll'
    | 'emptyText'
  > {
  dropdownPrefixCls?: string;
  dataSource?: RcTableProps<RecordType>['data'];
  columns?: ColumnsType<RecordType>;
  pagination?: false | TablePaginationConfig;
  loading?: boolean | SpinProps;
  size?: SizeType;
  bordered?: boolean;
  locale?: TableLocale;

  onChange?: (
    pagination: TablePaginationConfig,
    filters: Record<string, FilterValue | null>,
    sorter: SorterResult<RecordType> | SorterResult<RecordType>[],
    extra: TableCurrentDataSource<RecordType>,
  ) => void;
  rowSelection?: TableRowSelection<RecordType>;

  getPopupContainer?: GetPopupContainer;
  scroll?: RcTableProps<RecordType>['scroll'] & {
    scrollToFirstRowOnChange?: boolean;
  };
  sortDirections?: SortOrder[];
  showSorterTooltip?: boolean | TooltipProps;
}

const InteralTable = defineComponent<TableProps>({
  name: 'InteralTable',
  props: {} as any,
  inheritAttrs: false,
  emits: [],
  slots: ['emptyText', 'expandIcon', 'title', 'footer', 'summary'],
  setup(props, { attrs, slots, emit }) {
    devWarning(
      !(typeof props.rowKey === 'function' && props.rowKey.length > 1),
      'Table',
      '`index` parameter of `rowKey` function is deprecated. There is no guarantee that it will work as expected.',
    );

    const screens = useBreakpoint();

    const mergedColumns = computed(() => {
      const matched = new Set(Object.keys(screens).filter((m: Breakpoint) => screens[m]));

      return props.columns.filter(
        (c: ColumnType<DefaultRecordType>) =>
          !c.responsive || c.responsive.some((r: Breakpoint) => matched.has(r)),
      );
    });

    const {
      size: mergedSize,
      renderEmpty,
      direction,
      prefixCls,
      configProvider,
    } = useConfigInject('table', props);
    const [tableLocale] = useLocaleReceiver('Table', defaultLocale.Table, toRef(props, 'locale'));
    const rawData = computed(() => props.dataSource || EMPTY_LIST);

    const dropdownPrefixCls = computed(() =>
      configProvider.getPrefixCls('dropdown', props.dropdownPrefixCls),
    );

    const childrenColumnName = computed(() => props.childrenColumnName || 'children');

    const expandType = computed<ExpandType>(() => {
      if (rawData.value.some(item => (item as any)?.[childrenColumnName.value])) {
        return 'nest';
      }

      if (props.expandedRowRender) {
        return 'row';
      }

      return null;
    });

    const internalRefs = {
      body: ref<HTMLDivElement>(),
    };

    // ============================ RowKey ============================
    const getRowKey = computed<GetRowKey<DefaultRecordType>>(() => {
      if (typeof props.rowKey === 'function') {
        return props.rowKey;
      }

      return record => (record as any)?.[props.rowKey as string];
    });

    const [getRecordByKey] = useLazyKVMap(rawData, childrenColumnName, getRowKey);

    // ============================ Events =============================
    const changeEventInfo: Partial<ChangeEventInfo> = {};

    const triggerOnChange = (
      info: Partial<ChangeEventInfo>,
      action: TableAction,
      reset: boolean = false,
    ) => {
      const { pagination, scroll, onChange } = props;
      const changeInfo = {
        ...changeEventInfo,
        ...info,
      };

      if (reset) {
        changeEventInfo.resetPagination!();

        // Reset event param
        if (changeInfo.pagination!.current) {
          changeInfo.pagination!.current = 1;
        }

        // Trigger pagination events
        if (pagination && pagination.onChange) {
          pagination.onChange(1, changeInfo.pagination!.pageSize);
        }
      }

      if (scroll && scroll.scrollToFirstRowOnChange !== false && internalRefs.body.value) {
        scrollTo(0, {
          getContainer: () => internalRefs.body.value!,
        });
      }

      onChange?.(changeInfo.pagination!, changeInfo.filters!, changeInfo.sorter!, {
        currentDataSource: getFilterData(
          getSortData(rawData.value, changeInfo.sorterStates!, childrenColumnName.value),
          changeInfo.filterStates!,
        ),
        action,
      });
    };

    /**
     * Controlled state in `columns` is not a good idea that makes too many code (1000+ line?) to read
     * state out and then put it back to title render. Move these code into `hooks` but still too
     * complex. We should provides Table props like `sorter` & `filter` to handle control in next big version.
     */

    // ============================ Sorter =============================
    const onSorterChange = (sorter: SorterResult | SorterResult[], sorterStates: SortState[]) => {
      triggerOnChange(
        {
          sorter,
          sorterStates,
        },
        'sort',
        false,
      );
    };

    const [transformSorterColumns, sortStates, sorterTitleProps, sorters] = useSorter({
      prefixCls,
      mergedColumns,
      onSorterChange,
      sortDirections: computed(() => props.sortDirections || ['ascend', 'descend']),
      tableLocale,
      showSorterTooltip: toRef(props, 'showSorterTooltip'),
    });
    const sortedData = computed(() =>
      getSortData(rawData.value, sortStates.value, childrenColumnName.value),
    );

    // ============================ Filter ============================
    const onFilterChange = (filters: Record<string, FilterValue>, filterStates: FilterState[]) => {
      triggerOnChange(
        {
          filters,
          filterStates,
        },
        'filter',
        true,
      );
    };

    const [transformFilterColumns, filterStates, filters] = useFilter({
      prefixCls,
      locale: tableLocale,
      dropdownPrefixCls,
      mergedColumns,
      onFilterChange,
      getPopupContainer: toRef(props, 'getPopupContainer'),
    });
    const mergedData = computed(() => getFilterData(sortedData.value, filterStates.value));
    // ============================ Column ============================
    const columnTitleProps = computed(() => ({
      ...sorterTitleProps.value,
    }));
    const [transformTitleColumns] = useTitleColumns(columnTitleProps);

    // ========================== Pagination ==========================
    const onPaginationChange = (current: number, pageSize: number) => {
      triggerOnChange(
        {
          pagination: { ...changeEventInfo.pagination, current, pageSize },
        },
        'paginate',
      );
    };

    const [mergedPagination, resetPagination] = usePagination(
      computed(() => mergedData.value.length),
      toRef(props, 'pagination'),
      onPaginationChange,
    );

    watchEffect(() => {
      changeEventInfo.sorter = sorters.value;
      changeEventInfo.sorterStates = sortStates.value;

      changeEventInfo.filters = filters.value;
      changeEventInfo.filterStates = filterStates.value;
      changeEventInfo.pagination =
        props.pagination === false
          ? {}
          : getPaginationParam(props.pagination, mergedPagination.value);

      changeEventInfo.resetPagination = resetPagination;
    });

    // ============================= Data =============================
    const pageData = computed(() => {
      if (props.pagination === false || !mergedPagination.value.pageSize) {
        return mergedData.value;
      }

      const { current = 1, total, pageSize = DEFAULT_PAGE_SIZE } = mergedPagination.value;
      devWarning(current > 0, 'Table', '`current` should be positive number.');

      // Dynamic table data
      if (mergedData.value.length < total!) {
        if (mergedData.value.length > pageSize) {
          devWarning(
            false,
            'Table',
            '`dataSource` length is less than `pagination.total` but large than `pagination.pageSize`. Please make sure your config correct data with async mode.',
          );
          return mergedData.value.slice((current - 1) * pageSize, current * pageSize);
        }
        return mergedData.value;
      }

      return mergedData.value.slice((current - 1) * pageSize, current * pageSize);
    });

    // ========================== Selections ==========================
    const [transformSelectionColumns, selectedKeySet] = useSelection(
      computed(() => props.rowSelection),
      {
        prefixCls,
        data: mergedData,
        pageData,
        getRowKey,
        getRecordByKey,
        expandType,
        childrenColumnName,
        locale: tableLocale,
        expandIconColumnIndex: computed(() => props.expandIconColumnIndex),
        getPopupContainer: computed(() => props.getPopupContainer),
      },
    );

    const internalRowClassName = (record: any, index: number, indent: number) => {
      let mergedRowClassName;
      const { rowClassName } = props;
      if (typeof rowClassName === 'function') {
        mergedRowClassName = classNames(rowClassName(record, index, indent));
      } else {
        mergedRowClassName = classNames(rowClassName);
      }

      return classNames(
        {
          [`${prefixCls}-row-selected`]: selectedKeySet.value.has(getRowKey.value(record, index)),
        },
        mergedRowClassName,
      );
    };

    const expandIconColumnIndex = computed(() => {
      // Adjust expand icon index, no overwrite expandIconColumnIndex if set.
      if (expandType.value === 'nest' && props.expandIconColumnIndex === undefined) {
        return props.rowSelection ? 1 : 0;
      } else if (props.expandIconColumnIndex! > 0 && props.rowSelection) {
        return props.expandIconColumnIndex - 1;
      }
      return props.expandIconColumnIndex;
    });

    const indentSize = computed(() => {
      // Indent size
      return typeof props.indentSize === 'number' ? props.indentSize : 15;
    });

    const transformColumns = (innerColumns: ColumnsType<any>): ColumnsType<any> =>
      transformTitleColumns(
        transformSelectionColumns(transformFilterColumns(transformSorterColumns(innerColumns))),
      );

    return () => {
      const {
        expandIcon = slots.expandIcon || renderExpandIcon(tableLocale.value),
        pagination,
        loading,
        bordered,
      } = props;

      let topPaginationNode;
      let bottomPaginationNode;
      if (pagination !== false && mergedPagination.value?.total) {
        let paginationSize: TablePaginationConfig['size'];
        if (mergedPagination.value.size) {
          paginationSize = mergedPagination.value.size;
        } else {
          paginationSize =
            mergedSize.value === 'small' || mergedSize.value === 'middle' ? 'small' : undefined;
        }

        const renderPagination = (position: string) => (
          <Pagination
            class={`${prefixCls.value}-pagination ${prefixCls.value}-pagination-${position}`}
            {...mergedPagination.value}
            size={paginationSize}
          />
        );
        const defaultPosition = direction.value === 'rtl' ? 'left' : 'right';
        const { position } = mergedPagination.value;
        if (position !== null && Array.isArray(position)) {
          const topPos = position.find(p => p.indexOf('top') !== -1);
          const bottomPos = position.find(p => p.indexOf('bottom') !== -1);
          const isDisable = position.every(p => `${p}` === 'none');
          if (!topPos && !bottomPos && !isDisable) {
            bottomPaginationNode = renderPagination(defaultPosition);
          }
          if (topPos) {
            topPaginationNode = renderPagination(topPos!.toLowerCase().replace('top', ''));
          }
          if (bottomPos) {
            bottomPaginationNode = renderPagination(bottomPos!.toLowerCase().replace('bottom', ''));
          }
        } else {
          bottomPaginationNode = renderPagination(defaultPosition);
        }
      }

      // >>>>>>>>> Spinning
      let spinProps: SpinProps | undefined;
      if (typeof loading === 'boolean') {
        spinProps = {
          spinning: loading,
        };
      } else if (typeof loading === 'object') {
        spinProps = {
          spinning: true,
          ...loading,
        };
      }

      const wrapperClassNames = classNames(
        `${prefixCls.value}-wrapper`,
        {
          [`${prefixCls.value}-wrapper-rtl`]: direction.value === 'rtl',
        },
        attrs.class,
      );
      const tableProps = omit(props, ['columns']);
      return (
        <div class={wrapperClassNames} style={attrs.style}>
          <Spin spinning={false} {...spinProps}>
            {topPaginationNode}
            <RcTable
              {...tableProps}
              expandIconColumnIndex={expandIconColumnIndex.value}
              indentSize={indentSize.value}
              expandIcon={expandIcon}
              columns={mergedColumns.value}
              direction={direction.value}
              prefixCls={prefixCls.value}
              class={classNames({
                [`${prefixCls.value}-middle`]: mergedSize.value === 'middle',
                [`${prefixCls.value}-small`]: mergedSize.value === 'small',
                [`${prefixCls.value}-bordered`]: bordered,
                [`${prefixCls.value}-empty`]: rawData.value.length === 0,
              })}
              data={pageData.value}
              rowKey={getRowKey.value}
              rowClassName={internalRowClassName}
              // Internal
              internalHooks={INTERNAL_HOOKS}
              internalRefs={internalRefs as any}
              transformColumns={transformColumns}
              v-slots={{
                ...slots,
                emptyText: () =>
                  slots.emptyText?.() || tableLocale.value.emptyText || renderEmpty.value('Table'),
              }}
            />
            {bottomPaginationNode}
          </Spin>
        </div>
      );
    };
  },
});

const Table = defineComponent<TableProps>({
  name: 'ATable',
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => {
      const columns = (attrs.columns || convertChildrenToColumns(slots.default?.())) as ColumnsType;
      return <InteralTable {...attrs} columns={columns || []} v-slots={slots} />;
    };
  },
});

Table.SELECTION_ALL = SELECTION_ALL;
Table.SELECTION_INVERT = SELECTION_INVERT;
Table.SELECTION_NONE = SELECTION_NONE;
Table.Column = Column;
Table.ColumnGroup = ColumnGroup;
Table.Summary = Summary;

export default Table;
